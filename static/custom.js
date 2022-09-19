(function ($) {

    "use strict";

        // PRE loader
        $(window).load(function(){
          $('.preloader').fadeOut(1000); // set duration in brackets    
        });


        //Navigation Section
        $('.navbar-collapse a').on('click',function(){
          $(".navbar-collapse").collapse('hide');
        });

        $(window).scroll(function() {
          if ($(".navbar").offset().top > 50) {
            $(".navbar-fixed-top").addClass("top-nav-collapse");
              } else {
                $(".navbar-fixed-top").removeClass("top-nav-collapse");
              }
        });

        var form = document.getElementById("contact-form");
    
    async function handleSubmit(event) {
      event.preventDefault();
      var status = document.getElementById("my-form-status");
      var data = new FormData(event.target);
      fetch(event.target.action, {
        method: form.method,
        body: data,
        headers: {
            'Accept': 'application/json'
        }
      }).then(response => {
        if (response.ok) {
          status.innerHTML = "Vaše zpráva je úspěšně odeslaná. Děkujeme";
          form.reset()
        } else {
          response.json().then(data => {
            if (Object.hasOwn(data, 'errors')) {
              status.innerHTML = data["errors"].map(error => error["message"]).join(", ")
            } else {
              status.innerHTML = "Omlouváme se, nastal problém při odesílání vaší zprávy. Napište prosím na velointest@velointest.cz nebo zavolejte na 777 271 896."
            }
          })
        }
      }).catch(error => {
        status.innerHTML = "Omlouváme se, nastal problém při odesílání vaší zprávy. Napište prosím na velointest@velointest.cz nebo zavolejte na 777 271 896."
      });
    }
    form.addEventListener("submit", handleSubmit)


        // Owl Carousel
        var owl = $("#owl-testimonial");
          owl.owlCarousel({
            autoPlay: false,
            items : 1,
            itemsDesktop : [1199,1],
            itemsDesktopSmall : [979,1],
            itemsTablet: [768,1],
            itemsTabletSmall: false,
            itemsMobile : [479,1],
            Speedfast: 200,
        });


        // Smoothscroll js
        $(function() {
          $('.custom-navbar a, #home a, #service a').on('click', function(event) {
            var $anchor = $(this);
            $('html, body').stop().animate({
                scrollTop: $($anchor.attr('href')).offset().top - 49
            }, 500);
            event.preventDefault();
          });
        });  


})(jQuery);
